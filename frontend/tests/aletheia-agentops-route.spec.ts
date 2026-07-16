import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const HEARING_NOTICE_SOURCE_TITLE = "杭州市中级人民法院开庭通知";
const PAYMENT_DUE_SOURCE_FACT = "争议款项约定付款日为2026年9月1日";

type SmokeState = {
  projects: Record<
    string,
    Record<"agentops", {
      matterId: string;
      matterUrl: string;
      matterTitle: string;
    }>
  >;
};

function smokeState(): SmokeState {
  return JSON.parse(
    readFileSync(
      path.join(process.cwd(), ".next-ui-smoke-state.json"),
      "utf8",
    ),
  ) as SmokeState;
}

test("matter-scoped AgentOps route renders adapter-backed artifacts", async ({
  page,
}, testInfo) => {
  const state = smokeState();
  const projectState = state.projects[testInfo.project.name]?.agentops;
  if (!projectState) {
    throw new Error(`Missing UI smoke state for ${testInfo.project.name}`);
  }

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(`/aletheia/matters/${projectState.matterId}/agentops`);

  await expect(page).toHaveTitle(/Vera/);
  await expect(page).toHaveURL(
    new RegExp(`/aletheia/matters/${projectState.matterId}/agentops$`),
  );
  await expect(page.locator("body")).not.toContainText("Mock mode");
  await expect(page.getByTestId("adapter-backed-command-center")).toBeVisible();
  await expect(page.getByText("Adapter-backed matter")).toBeVisible();
  await expect(page.getByText("1/1 source-linked evidence")).toBeVisible();

  const commandCenter = page.getByTestId("adapter-backed-command-center");
  await expect(commandCenter).toContainText(projectState.matterTitle);
  await expect(commandCenter).toContainText("Matter Command Center");
  await expect(commandCenter).toContainText("Professional workflow");
  await expect(commandCenter).toContainText("Evidence");
  await expect(commandCenter).toContainText("Issue");
  await expect(commandCenter).toContainText("Risk");
  await expect(commandCenter).toContainText("Memo");
  await expect(commandCenter).toContainText("Review");
  await expect(commandCenter).toContainText("Gate");
  await expect(commandCenter).toContainText("Audit");
  await expect(commandCenter).toContainText("Eval");
  await expect(commandCenter).toContainText(HEARING_NOTICE_SOURCE_TITLE);
  await expect(commandCenter).toContainText(PAYMENT_DUE_SOURCE_FACT);
  await expect(commandCenter).toContainText("Draft professional work product");
  await expect(commandCenter).toContainText("audit_pack_exported");
  await expect(commandCenter).toContainText("litigation_brief_generated");
  await expect(page.getByTestId("external-source-workpaper-panel")).toContainText(
    "Captures remain review-only. Automatic retrieval requires a configured HTTPS allowlist.",
  );
  await page
    .getByTestId("external-source-query")
    .fill("issuer public-source verification");
  await page
    .getByTestId("external-source-url")
    .fill("https://example.test/issuer");
  await page
    .getByTestId("external-source-observation")
    .fill("Captured public issuer profile for counsel review.");
  await page.getByTestId("external-source-opt-in").check();
  await page.getByTestId("record-external-source-workpaper").click();
  await expect(
    page.getByTestId("external-source-workpaper-status"),
  ).toContainText("External-source workpaper recorded");
  const externalSourceRecord = page
    .getByTestId("external-source-workpaper-record")
    .first();
  await expect(externalSourceRecord).toContainText(
    "https://example.test/issuer",
  );
  await expect(externalSourceRecord).toContainText(
    "needs review",
  );
  await expect(externalSourceRecord).toContainText(
    "Provenance validated",
  );
  await expect(
    commandCenter
      .getByRole("link", {
        name: new RegExp(HEARING_NOTICE_SOURCE_TITLE),
      })
      .first(),
  ).toHaveAttribute(
    "href",
    new RegExp(
      `/aletheia/matters/${projectState.matterId}/agentops#artifact-evidence-item-`,
    ),
  );

  await expect(page.getByTestId("agentops-gate-checklist")).toBeVisible();
  await expect(page.getByTestId("agentops-gate-checklist")).toContainText(
    "Trust gates",
  );
  await expect(page.getByTestId("agentops-gate-checklist")).toContainText(
    "Final export blocked",
  );
  await expect(page.getByTestId("agentops-gate-provenance")).toContainText(
    "Gate Provenance",
  );
  await expect(page.getByTestId("agentops-gate-provenance")).toContainText(
    "Displayed gates mapped back to persisted Vera records.",
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
          "original document/page preview is not embedded",
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
    "Candidate skills",
  );
  await expect(page.getByTestId("agentops-eval-workbench")).toContainText(
    "Approval required",
  );
  await expect(page.getByTestId("agentops-eval-workbench")).toContainText(
    "Approved playbook skills",
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
    new RegExp(
      `/aletheia/matters/${projectState.matterId}/litigation\\?view=overview$`,
    ),
  );
  await expect(
    page.getByRole("heading", { name: projectState.matterTitle }),
  ).toBeVisible();

  expect(consoleErrors).toEqual([]);
});
