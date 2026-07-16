import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createVeraMatter,
  createVeraMatterProfile,
  parseVeraMatterPageWire,
  parseVeraMatterWire,
  updateVeraMatterProfile,
  VERA_WORKSPACE_TYPES,
} from "../src/app/lib/veraMatterApi.ts";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const NOW = "2026-07-16T10:00:00.000Z";

function projectWire(status: "active" | "archived" | "deleted" = "active") {
  return {
    id: PROJECT_ID,
    name: "Meridian acquisition",
    description: "",
    cm_number: "M-2026-0042",
    practice: "Corporate",
    status,
    default_model_profile_id: null,
    created_at: NOW,
    updated_at: NOW,
    archived_at: status === "active" ? null : NOW,
    document_count: 3,
    chat_count: 1,
    tabular_review_count: 2,
    workflow_count: 4,
  };
}

function profileWire(workspaceType: string | null = "transaction") {
  return {
    project_id: PROJECT_ID,
    workspace_type: workspaceType,
    client_name: "Meridian Ltd",
    jurisdiction: "PRC",
    represented_role: "Buyer counsel",
    objective: "Complete the acquisition with reviewed closing documents.",
    created_at: NOW,
    updated_at: NOW,
  };
}

function capabilities(
  profile: "create" | "classify" | "edit" | "unavailable",
  inference:
    | "workspace_compatibility"
    | "policy_gate_closed"
    | "unavailable",
) {
  return {
    matter_profile: profile,
    inference,
    review: "unavailable",
    drafts: "document_scoped",
  };
}

function matterWire(
  kind: "absent" | "classification_required" | "ready",
  status: "active" | "archived" | "deleted" = "active",
) {
  const lifecycleCapabilities =
    status === "active"
      ? null
      : capabilities("unavailable", "unavailable");
  if (kind === "absent") {
    return {
      project: projectWire(status),
      matter_profile: null,
      profile_state: "absent",
      capabilities:
        lifecycleCapabilities ?? capabilities("create", "workspace_compatibility"),
    };
  }
  return {
    project: projectWire(status),
    matter_profile: profileWire(
      kind === "classification_required" ? null : "transaction",
    ),
    profile_state: kind,
    capabilities:
      lifecycleCapabilities ??
      capabilities(
        kind === "classification_required" ? "classify" : "edit",
        "policy_gate_closed",
      ),
  };
}

test("Matter wire accepts the three truthful profile states and broad taxonomy", () => {
  assert.deepEqual(VERA_WORKSPACE_TYPES, [
    "general_legal",
    "transaction",
    "dispute",
    "investigation",
    "compliance",
    "research",
  ]);
  for (const state of [
    "absent",
    "classification_required",
    "ready",
  ] as const) {
    const parsed = parseVeraMatterWire(matterWire(state));
    assert.equal(parsed.profile_state, state);
  }
  for (const lifecycle of ["archived", "deleted"] as const) {
    for (const state of [
      "absent",
      "classification_required",
      "ready",
    ] as const) {
      const readOnly = parseVeraMatterWire(matterWire(state, lifecycle));
      assert.equal(readOnly.profile_state, state);
      assert.equal(readOnly.capabilities.matter_profile, "unavailable");
      assert.equal(readOnly.capabilities.inference, "unavailable");
    }
  }
  assert.equal(
    parseVeraMatterPageWire({
      items: [matterWire("ready")],
      next_cursor: "bmV4dA",
    }).items[0]?.project.tabular_review_count,
    2,
  );
});

test("Matter wire fails closed on old litigation fields and capability drift", () => {
  assert.throws(() =>
    parseVeraMatterWire({
      ...matterWire("ready"),
      matter_profile: {
        ...profileWire(),
        matter_type: "civil_litigation",
      },
    }),
  );
  assert.throws(() =>
    parseVeraMatterWire({
      ...matterWire("ready", "archived"),
      capabilities: capabilities("edit", "policy_gate_closed"),
    }),
  );
  assert.throws(() =>
    parseVeraMatterWire({
      ...matterWire("ready"),
      capabilities: capabilities("unavailable", "unavailable"),
    }),
  );
  assert.throws(() =>
    parseVeraMatterWire({
      ...matterWire("ready"),
      project: {
        ...projectWire(),
        review_count: 2,
      },
    }),
  );
  assert.throws(() =>
    parseVeraMatterWire({
      ...matterWire("ready"),
      capabilities: capabilities("edit", "workspace_compatibility"),
    }),
  );
  assert.throws(() =>
    parseVeraMatterWire({
      ...matterWire("classification_required"),
      profile_state: "ready",
    }),
  );
  assert.throws(() =>
    parseVeraMatterPageWire({ items: [], next_cursor: "unsafe/cursor" }),
  );
});

test("Matter mutations reject unbounded, unknown, and unclassified input before transport", async () => {
  await assert.rejects(
    createVeraMatter({
      workspace_type: "general_legal",
    } as never),
  );
  await assert.rejects(
    createVeraMatter({
      name: "Unclassified",
      workspace_type: "legacy" as never,
    }),
  );
  await assert.rejects(
    createVeraMatter({
      name: " padded ",
      workspace_type: "general_legal",
    }),
  );
  await assert.rejects(
    createVeraMatterProfile(
      PROJECT_ID,
      {
        workspace_type: "general_legal",
        objective: `x${"y".repeat(16_384)}`,
      },
    ),
  );
  await assert.rejects(updateVeraMatterProfile(PROJECT_ID, {}));
  await assert.rejects(
    updateVeraMatterProfile(PROJECT_ID, { objective: undefined }),
  );
  await assert.rejects(
    updateVeraMatterProfile(PROJECT_ID, {
      workspace_type: "research",
      unknown: true,
    } as never),
  );
});

test("Gate 1 IA preserves deep links while exposing only truthful Matter surfaces", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const read = (relative: string) =>
    readFile(path.join(root, relative), "utf8");
  const [sidebar, navigation, list, detail, modal, api, config, mattersPage] =
    await Promise.all([
      read("src/app/components/vera-shell/VeraSidebar.tsx"),
      read("src/features/matter-overview/MatterNavigation.tsx"),
      read("src/features/matter-overview/MattersOverview.tsx"),
      read("src/features/matter-overview/MatterWorkspaceOverview.tsx"),
      read("src/features/matter-overview/MatterProfileModal.tsx"),
      read("src/app/lib/veraMatterApi.ts"),
      read("next.config.ts"),
      read("src/app/(pages)/matters/page.tsx"),
    ]);

  const assistant = sidebar.indexOf('labelKey: "nav.assistant"');
  const matters = sidebar.indexOf('labelKey: "nav.matters"');
  const workflows = sidebar.indexOf('labelKey: "nav.workflows"');
  const review = sidebar.indexOf('labelKey: "nav.review"');
  const settings = sidebar.indexOf('labelKey: "nav.settings"');
  assert.ok(
    assistant < matters && matters < workflows && workflows < review && review < settings,
  );
  assert.match(sidebar, /href: null, labelKey: "nav\.review"/);
  assert.doesNotMatch(sidebar, /labelKey: "nav\.(?:projects|tabular)"/);
  assert.match(sidebar, /pathname\.startsWith\("\/projects\/"\)/);

  assert.match(config, /source: "\/projects"[\s\S]*destination: "\/matters"/);
  assert.match(mattersPage, /<MattersOverview \/>/);
  assert.match(navigation, /`\/projects\/\$\{projectId\}`/);
  assert.match(navigation, /`\/projects\/\$\{projectId\}\/workflows`/);
  assert.match(navigation, /!inferenceAvailable \? \(/);
  assert.match(navigation, /capabilities\.inference === "unavailable"/);
  assert.match(navigation, /matters\.navigation\.review/);
  assert.match(navigation, /matters\.navigation\.drafts/);
  assert.match(navigation, /disabled[\s\S]*aria-disabled="true"/);

  assert.match(list, /profile_state !== "absent"/);
  assert.match(list, /profile_state === "absent"/);
  assert.match(
    list,
    /mode:\s*action === "create" \? "create-profile" : "edit-profile"/,
  );
  assert.match(detail, /capabilities\.inference === "policy_gate_closed"/);
  assert.match(detail, /capabilities\.matter_profile !== "unavailable"/);
  assert.match(detail, /capabilities\.inference === "unavailable"/);
  assert.match(list, /action === "unavailable"/);
  assert.match(detail, /project\.tabular_review_count/);
  assert.match(modal, /workspace_type: form\.workspaceType/);
  assert.match(api, /veraApiRequest<unknown>\("\/matters"/);

  const gateOneSources = `${navigation}\n${list}\n${detail}\n${modal}\n${api}`;
  assert.doesNotMatch(
    gateOneSources,
    /\b(?:matter_type|counterparty|court|case_number|risk_level|opened_at|closed_at|review_count)\b/,
  );
  assert.doesNotMatch(
    gateOneSources,
    /next best action|deadline|research result|unified review count/i,
  );
});
