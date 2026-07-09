import { readFileSync } from "node:fs";
import path from "node:path";

type PolicyCheck = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  detail: string;
};

const EXPECTED_ENABLED_TOOLS = [
  "list_matters",
  "read_matter",
  "search_matter_documents",
  "read_evidence_item",
  "create_work_product",
  "add_review_tag",
  "append_audit_event",
  "export_audit_pack",
];

const EXPECTED_DISABLED_TOOLS = [
  "browser",
  "terminal",
  "external_web_search",
  "email",
  "destructive_file_operations",
];

function repoRoot() {
  return path.resolve(process.cwd(), "..");
}

function readText(root: string, relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function quotedStrings(value: string) {
  return Array.from(value.matchAll(/["']([^"']+)["']/g)).map(
    (match) => match[1],
  );
}

function extractConstArray(source: string, constName: string) {
  const match = source.match(
    new RegExp(`const\\s+${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*(?:as const)?`),
  );
  return match ? quotedStrings(match[1]) : [];
}

function extractMcpTools(source: string) {
  return Array.from(source.matchAll(/server\.registerTool\(\s*["']([^"']+)["']/g))
    .map((match) => match[1])
    .sort();
}

function sameSet(actual: string[], expected: string[]) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  return (
    actualSorted.length === expectedSorted.length &&
    actualSorted.every((value, index) => value === expectedSorted[index])
  );
}

function missing(actual: string[], expected: string[]) {
  return expected.filter((value) => !actual.includes(value));
}

function extra(actual: string[], expected: string[]) {
  return actual.filter((value) => !expected.includes(value));
}

function check(
  id: string,
  ok: boolean,
  detail: string,
  severity: "critical" | "warning" = "critical",
): PolicyCheck {
  return { id, ok, severity, detail };
}

function main() {
  const root = repoRoot();
  const routeSource = readText(root, "backend/src/routes/aletheia.ts");
  const mcpSource = readText(root, "backend/src/mcp/aletheiaServer.ts");
  const docs = readText(root, "docs/aletheia_tool_adapter.md");
  const domainSource = readText(root, "backend/src/lib/aletheia/domain.ts");

  const httpEnabled = extractConstArray(routeSource, "TOOL_ADAPTER_TOOLS");
  const httpDisabled = extractConstArray(
    routeSource,
    "DISABLED_TOOL_ADAPTER_TOOLS",
  );
  const mcpEnabled = extractMcpTools(mcpSource);
  const docsEnabled = EXPECTED_ENABLED_TOOLS.filter((tool) =>
    docs.includes(`\`${tool}\``),
  );
  const docsDisabled = EXPECTED_DISABLED_TOOLS.filter((tool) =>
    docs.includes(`\`${tool}\``),
  );
  const prohibitedMcpMatches = EXPECTED_DISABLED_TOOLS.filter((tool) =>
    mcpEnabled.includes(tool),
  );

  const checks: PolicyCheck[] = [
    check(
      "http-enabled-tool-allowlist",
      sameSet(httpEnabled, EXPECTED_ENABLED_TOOLS),
      sameSet(httpEnabled, EXPECTED_ENABLED_TOOLS)
        ? "HTTP Tool Adapter exposes exactly the expected enabled allowlist."
        : `HTTP enabled mismatch. missing=${missing(httpEnabled, EXPECTED_ENABLED_TOOLS).join(",") || "none"} extra=${extra(httpEnabled, EXPECTED_ENABLED_TOOLS).join(",") || "none"}`,
    ),
    check(
      "http-disabled-tool-denylist",
      sameSet(httpDisabled, EXPECTED_DISABLED_TOOLS),
      sameSet(httpDisabled, EXPECTED_DISABLED_TOOLS)
        ? "HTTP Tool Adapter manifest reports the expected disabled high-risk tools."
        : `HTTP disabled mismatch. missing=${missing(httpDisabled, EXPECTED_DISABLED_TOOLS).join(",") || "none"} extra=${extra(httpDisabled, EXPECTED_DISABLED_TOOLS).join(",") || "none"}`,
    ),
    check(
      "mcp-enabled-tool-allowlist",
      sameSet(mcpEnabled, EXPECTED_ENABLED_TOOLS),
      sameSet(mcpEnabled, EXPECTED_ENABLED_TOOLS)
        ? "MCP wrapper registers exactly the expected enabled allowlist."
        : `MCP enabled mismatch. missing=${missing(mcpEnabled, EXPECTED_ENABLED_TOOLS).join(",") || "none"} extra=${extra(mcpEnabled, EXPECTED_ENABLED_TOOLS).join(",") || "none"}`,
    ),
    check(
      "mcp-no-disabled-tools",
      prohibitedMcpMatches.length === 0,
      prohibitedMcpMatches.length
        ? `Disabled high-risk tools registered in MCP: ${prohibitedMcpMatches.join(", ")}`
        : "MCP wrapper does not register disabled high-risk tools.",
    ),
    check(
      "docs-tool-policy-complete",
      sameSet(docsEnabled, EXPECTED_ENABLED_TOOLS) &&
        sameSet(docsDisabled, EXPECTED_DISABLED_TOOLS) &&
        docs.includes("least privilege") &&
        docs.includes("does not bypass approval"),
      "Tool Adapter docs must list enabled tools, disabled tools, least privilege, and approval-gate posture.",
    ),
    check(
      "runtime-policy-signals-present",
      routeSource.includes("dangerousToolsDisabledByDefault") &&
        routeSource.includes("highRiskActionsRequireHumanApproval") &&
        domainSource.includes('defaultToolPolicy: "allowlist_per_step"') &&
        domainSource.includes('externalNetworkDefault: "disabled"') &&
        domainSource.includes('destructiveActionsDefault: "disabled"'),
      "Runtime manifests must expose least-privilege and disabled network/destructive-action policy signals.",
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
        suite: "aletheia-tool-policy-audit-v0",
        checkedAt: new Date().toISOString(),
        enabledTools: EXPECTED_ENABLED_TOOLS,
        disabledTools: EXPECTED_DISABLED_TOOLS,
        observed: {
          httpEnabled,
          httpDisabled,
          mcpEnabled,
        },
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
