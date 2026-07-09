import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

type SmokeState = {
  projects: Record<
    string,
    {
      matterId: string;
      matterUrl: string;
    }
  >;
};

function smokeState(): SmokeState {
  return JSON.parse(
    readFileSync(
      path.join(process.cwd(), "test-results", "aletheia-ui-smoke-state.json"),
      "utf8",
    ),
  ) as SmokeState;
}

test("matter-scoped AgentOps route renders adapter-backed artifacts", async ({
  page,
}, testInfo) => {
  const state = smokeState();
  const projectState = state.projects[testInfo.project.name];
  if (!projectState) {
    throw new Error(`Missing UI smoke state for ${testInfo.project.name}`);
  }

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(`/aletheia/matters/${projectState.matterId}/agentops`);

  await expect(page).toHaveTitle(/Aletheia/);
  await expect(page).toHaveURL(
    new RegExp(`/aletheia/matters/${projectState.matterId}/agentops$`),
  );
  await expect(page.locator("body")).not.toContainText("Mock mode");
  await expect(page.getByTestId("adapter-backed-command-center")).toBeVisible();
  await expect(page.getByText("Adapter-backed matter")).toBeVisible();
  await expect(page.getByText("1/1 source-linked evidence")).toBeVisible();

  const commandCenter = page.getByTestId("adapter-backed-command-center");
  await expect(commandCenter).toContainText("Aletheia UI Smoke Matter");
  await expect(commandCenter).toContainText("Matter Command Center");
  await expect(commandCenter).toContainText("Professional Workflow");
  await expect(commandCenter).toContainText("Evidence");
  await expect(commandCenter).toContainText("Issue");
  await expect(commandCenter).toContainText("Risk");
  await expect(commandCenter).toContainText("Memo");
  await expect(commandCenter).toContainText("Review");
  await expect(commandCenter).toContainText("Gate");
  await expect(commandCenter).toContainText("Audit");
  await expect(commandCenter).toContainText("Eval");
  await expect(commandCenter).toContainText(
    "Synthetic source record for Aletheia UI smoke",
  );
  await expect(commandCenter).toContainText("Termination notice requirement");
  await expect(commandCenter).toContainText("Draft Memo");
  await expect(commandCenter).toContainText("audit_pack_exported");
  await expect(commandCenter).toContainText("memo_generated");
  await expect(
    commandCenter
      .getByRole("link", { name: /Synthetic source record for Aletheia UI smoke/ })
      .first(),
  ).toHaveAttribute(
    "href",
    new RegExp(
      `/aletheia/matters/${projectState.matterId}/agentops#artifact-evidence-item-`,
    ),
  );

  await expect(page.getByTestId("agentops-gate-checklist")).toBeVisible();
  await expect(page.getByTestId("agentops-gate-checklist")).toContainText(
    "Trust Gates",
  );
  await expect(page.getByTestId("agentops-gate-checklist")).toContainText(
    "Final export blocked",
  );
  await expect(page.getByTestId("agentops-gate-provenance")).toContainText(
    "Gate Provenance",
  );
  await expect(page.getByTestId("agentops-gate-provenance")).toContainText(
    "Displayed gates mapped back to persisted Aletheia records.",
  );
  await expect(page.getByTestId("agentops-gate-provenance")).toContainText(
    "backed",
  );
  await expect(page.getByTestId("agentops-gate-provenance")).toContainText(
    "human approval",
  );
  await expect(page.getByTestId("agentops-gate-provenance")).toContainText(
    "human checkpoint",
  );
  await expect(page.getByTestId("agentops-gate-provenance")).toContainText(
    "audit events",
  );
  await expect(page.getByTestId("agentops-gate-provenance")).toContainText(
    "failed",
  );
  await expect(page.getByTestId("agentops-gate-provenance")).toContainText(
    "passed",
  );
  await expect(page.getByTestId("agentops-gate-provenance")).toContainText(
    "reviews",
  );
  await expect(page.getByTestId("agentops-gate-provenance")).toContainText(
    "work products",
  );

  await expect(page.getByTestId("adapter-backed-eval-signals")).toContainText(
    "Eval Signals",
  );
  await expect(page.getByTestId("adapter-backed-eval-signals")).toContainText(
    "Citation coverage",
  );
  await expect(page.getByTestId("adapter-backed-eval-signals")).toContainText(
    "Unsupported claims",
  );
  await expect(page.getByTestId("adapter-backed-export-package")).toContainText(
    "Audit Export Package",
  );
  await expect(page.getByTestId("adapter-backed-export-package")).toContainText(
    "typed_handoff_provenance",
  );
  await expect(page.getByTestId("adapter-backed-export-package")).toContainText(
    "gate source IDs",
  );
  await expect(page.getByTestId("adapter-backed-export-package")).toContainText(
    "fnv1a32:",
  );
  await expect(page.getByTestId("adapter-backed-export-package")).toContainText(
    "eval cases",
  );
  await expect(page.getByTestId("adapter-backed-export-package")).toContainText(
    "Source documents",
  );
  await expect(
    page.getByTestId("agentops-export-authorization-status"),
  ).toContainText("Export authorization");
  await expect(
    page.getByTestId("agentops-export-authorization-status"),
  ).toContainText("final export remains");
  await expect(page.getByTestId("agentops-source-index-status")).toContainText(
    "Local-only V1 source index included",
  );
  await page.getByText("Preview handoff payload").click();
  await expect(page.getByTestId("agentops-export-preview")).toContainText(
    "typed_handoff_provenance",
  );
  await expect(page.getByTestId("agentops-export-preview")).toContainText(
    "sourceRecordIds",
  );
  await expect(page.getByTestId("agentops-export-preview")).toContainText(
    "gateResultIds",
  );
  await expect(page.getByTestId("agentops-export-preview")).toContainText(
    "source_index_documents",
  );
  await expect(page.getByTestId("agentops-export-preview")).toContainText(
    "source_index_manifest",
  );
  await expect(page.getByTestId("agentops-export-preview")).toContainText(
    "export_authorization",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-agentops-export-package").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /agentops-export-package\.json$/,
  );
  const downloadPath = await download.path();
  if (!downloadPath) {
    throw new Error("AgentOps export package download path was unavailable");
  }
  const downloadedPackage = JSON.parse(readFileSync(downloadPath, "utf8")) as {
    schema_version?: string;
    audit_pack?: {
      source_index_manifest?: {
        local_only?: boolean;
        document_count?: number;
        chunk_count?: number;
        source_link_count?: number;
        limitations?: string[];
      };
      export_authorization?: {
        final_export_allowed?: boolean;
        status?: string;
      };
      typed_handoff_provenance?: unknown[];
    };
    manifest?: {
      handoff_provenance_items?: number;
      source_index_documents?: number;
      source_index_chunks?: number;
      source_index_source_links?: number;
      final_export_allowed?: boolean;
    };
  };
  expect(downloadedPackage.schema_version).toBe("aletheia-export-package-v1");
  expect(
    downloadedPackage.audit_pack?.typed_handoff_provenance?.length ?? 0,
  ).toBeGreaterThan(0);
  expect(downloadedPackage.manifest?.handoff_provenance_items).toBe(
    downloadedPackage.audit_pack?.typed_handoff_provenance?.length,
  );
  expect(downloadedPackage.audit_pack?.source_index_manifest?.local_only).toBe(
    true,
  );
  expect(downloadedPackage.manifest?.source_index_documents).toBe(
    downloadedPackage.audit_pack?.source_index_manifest?.document_count,
  );
  expect(downloadedPackage.manifest?.source_index_chunks).toBe(
    downloadedPackage.audit_pack?.source_index_manifest?.chunk_count,
  );
  expect(downloadedPackage.manifest?.source_index_source_links).toBe(
    downloadedPackage.audit_pack?.source_index_manifest?.source_link_count,
  );
  expect(downloadedPackage.manifest?.final_export_allowed).toBe(
    downloadedPackage.audit_pack?.export_authorization?.final_export_allowed,
  );
  expect(downloadedPackage.audit_pack?.export_authorization?.status).toMatch(
    /authorized|blocked|warning/,
  );
  expect(
    downloadedPackage.audit_pack?.source_index_manifest?.limitations?.some(
      (item) =>
        item.includes(
          "Supabase V1 document, chunk, and source-link listing remains unavailable",
        ),
    ),
  ).toBe(true);
  await expect(page.getByTestId("agentops-export-status")).toContainText(
    "Export package JSON prepared",
  );
  await expect(page.getByTestId("agentops-eval-workbench")).toBeVisible();
  await expect(page.getByTestId("agentops-eval-workbench")).toContainText(
    "Eval Workbench",
  );
  await expect(page.getByTestId("agentops-eval-workbench")).toContainText(
    "Citation Coverage",
  );
  await expect(page.getByTestId("agentops-eval-workbench")).toContainText(
    "Candidate Skills",
  );
  await expect(page.getByTestId("agentops-eval-workbench")).toContainText(
    "Approval required",
  );
  await expect(page.getByTestId("agentops-eval-workbench")).toContainText(
    "Approved Playbook Skills",
  );

  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "Matter References",
  );
  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "resolved",
  );
  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "ambiguous",
  );
  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "missing",
  );
  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "not used as support until resolved",
  );
  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "Autocomplete Candidates",
  );
  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "read-only suggestions",
  );
  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "@Matter:",
  );
  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "@Evidence:",
  );
  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "Evidence",
  );
  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "Clause",
  );
  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "source_chunk_id",
  );
  await expect(page.getByTestId("adapter-backed-references")).toContainText(
    "Gate",
  );

  await page.getByTestId("record-agentops-snapshot").click();
  await expect(page.getByTestId("agentops-snapshot-status")).toContainText(
    "AgentOps snapshot recorded",
  );
  await expect(commandCenter).toContainText("agentops_snapshot_recorded");

  await page.getByRole("link", { name: "Matter workspace" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/aletheia/matters/${projectState.matterId}$`),
  );
  await expect(page.getByTestId("aletheia-matter-workspace")).toBeVisible();

  expect(consoleErrors).toEqual([]);
});
