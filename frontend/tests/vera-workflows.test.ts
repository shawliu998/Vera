import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createVeraWorkflow,
  deleteVeraWorkflow,
  getVeraWorkflow,
  hideVeraWorkflow,
  listHiddenVeraWorkflows,
  listVeraWorkflows,
  parseVeraWorkflow,
  unhideVeraWorkflow,
  updateVeraWorkflow,
} from "../src/app/lib/veraWorkflowApi.ts";
import { VeraApiError } from "../src/app/lib/veraApi.ts";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "vdt_1234567890abcdefghijklmnopqrstuvwxyz";

function workflow(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    user_id: "00000000-0000-4000-8000-000000000001",
    metadata: {
      title: "合同摘要",
      description: null,
      type: "assistant",
      contributors: [],
      language: "中文",
      version: "2026-07-14T00:00:00.000Z",
      practice: "通用",
      jurisdictions: ["中国大陆"],
    },
    skill_md: "总结文件。",
    columns_config: null,
    is_system: false,
    created_at: "2026-07-14T00:00:00.000Z",
    shared_by_name: null,
    allow_edit: true,
    is_owner: true,
    open_source_submission: null,
    ...overrides,
  };
}

function installDesktop() {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      aletheiaDesktop: {
        async getInfo() {
          return { workspaceApiUrl: "http://127.0.0.1:43123/api/v1" };
        },
        async getAuthToken() {
          return TOKEN;
        },
      },
    },
  });
  return () => {
    if (prior) Object.defineProperty(globalThis, "window", prior);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

test("Mike workflow adapter accepts the exact safe wire and preserves all nine formats", () => {
  const tabular = workflow({
    metadata: { ...workflow().metadata, type: "tabular" },
    skill_md: "逐份检查。",
    columns_config: [
      "text",
      "bulleted_list",
      "number",
      "currency",
      "yes_no",
      "date",
      "tag",
      "percentage",
      "monetary_amount",
    ].map((format, index) => ({
      index,
      name: `列 ${index}`,
      prompt: "提取结果。",
      format,
      ...(format === "tag" ? { tags: ["高", "低"] } : {}),
    })),
  });
  const parsed = parseVeraWorkflow(tabular);
  assert.deepEqual(
    parsed.columns_config?.map((column) => column.format),
    [
      "text",
      "bulleted_list",
      "number",
      "currency",
      "yes_no",
      "date",
      "tag",
      "percentage",
      "monetary_amount",
    ],
  );
  assert.deepEqual(parsed.columns_config?.[0].tags, undefined);
  assert.deepEqual(parsed.columns_config?.[6].tags, ["高", "低"]);

  assert.throws(
    () => parseVeraWorkflow({ ...workflow(), storage_path: "/Users/private" }),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraWorkflow({
        ...tabular,
        columns_config: [
          { index: 0, name: "x", prompt: "y", format: "local", tags: [] },
        ],
      }),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraWorkflow({
        ...workflow(),
        metadata: { ...workflow().metadata, title: " " },
      }),
    VeraApiError,
  );
});

test("workflow CRUD and hide routes use the local Mike-compatible boundary with no fallback", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/workflows/hidden") && init?.method === "GET") {
      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/hidden") || init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("type=assistant")) {
      return new Response(JSON.stringify([workflow()]), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("type=tabular")) {
      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(workflow()), {
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    assert.equal((await listVeraWorkflows("assistant")).length, 1);
    await getVeraWorkflow("builtin-nda-review");
    await createVeraWorkflow({
      metadata: { title: "新工作流", type: "assistant", language: "中文" },
      skill_md: "整理重点。",
    });
    await updateVeraWorkflow(WORKFLOW_ID, { skill_md: "更新后的指令。" });
    assert.deepEqual(await listHiddenVeraWorkflows(), []);
    await hideVeraWorkflow("builtin-nda-review");
    await unhideVeraWorkflow("builtin-nda-review");
    await deleteVeraWorkflow(WORKFLOW_ID);

    assert.equal(
      calls[0].url,
      "http://127.0.0.1:43123/api/v1/workflows?type=assistant",
    );
    assert.equal(
      calls[1].url,
      "http://127.0.0.1:43123/api/v1/workflows/builtin-nda-review",
    );
    assert.equal(calls[2].init?.method, "POST");
    assert.equal(
      calls[2].init?.body,
      JSON.stringify({
        metadata: { title: "新工作流", type: "assistant", language: "中文" },
        skill_md: "整理重点。",
      }),
    );
    assert.equal(calls[3].init?.method, "PATCH");
    assert.equal(calls[5].init?.method, "POST");
    assert.equal(calls[6].init?.method, "DELETE");
    assert.equal(calls[7].init?.method, "DELETE");
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(call.url.includes(TOKEN), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Workflow UI retains Mike CRUD provenance but excludes disabled execution and cloud surfaces", () => {
  const root = path.resolve(__dirname, "..");
  const list = readFileSync(
    path.join(root, "src/app/components/workflows/VeraWorkflowList.tsx"),
    "utf8",
  );
  const editor = readFileSync(
    path.join(root, "src/app/components/workflows/VeraWorkflowEditor.tsx"),
    "utf8",
  );
  const adapter = readFileSync(
    path.join(root, "src/app/lib/veraWorkflowApi.ts"),
    "utf8",
  );
  const sidebar = readFileSync(
    path.join(root, "src/app/components/vera-shell/VeraSidebar.tsx"),
    "utf8",
  );
  assert.match(list, /e32daad5a4c64a5561e04c53ee12411e3c5e7238/);
  assert.match(editor, /e32daad5a4c64a5561e04c53ee12411e3c5e7238/);
  assert.match(adapter, /frontend\/src\/app\/lib\/mikeApi\.ts/);
  assert.match(list, /listVeraWorkflows\("assistant"/);
  assert.match(list, /listVeraWorkflows\("tabular"/);
  assert.match(list, /listHiddenVeraWorkflows/);
  assert.match(editor, /VERA_WORKFLOW_FORMATS/);
  assert.match(editor, /支持九种输出格式与标签语义。/);
  assert.doesNotMatch(editor, /保留 Mike 的九种输出格式与标签语义。/);
  assert.match(list, /role="link"/);
  assert.match(list, /tabIndex=\{0\}/);
  assert.match(list, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(list, /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(list, /hiddenPendingIds/);
  assert.match(list, /deletePendingIds/);
  assert.match(list, /const deleteControlsLocked =/);
  assert.match(list, /disabled=\{deleteControlsLocked \|\| deletePending\}/);
  assert.match(list, /if \(deleteControlsLocked\) return;/);
  assert.match(
    list,
    /visible\.length === 0 && workflows\.length > 0 && hasActiveFilter/,
  );
  assert.match(list, /清除筛选/);
  for (const field of ["name", "format", "prompt", "tags"]) {
    assert.match(
      editor,
      new RegExp("htmlFor=\\{`\\$\\{fieldId\\}-" + field + "`\\}"),
      `column ${field} needs an associated programmatic label`,
    );
    assert.match(
      editor,
      new RegExp("id=\\{`\\$\\{fieldId\\}-" + field + "`\\}"),
      `column ${field} needs a unique input id`,
    );
  }
  assert.match(
    editor,
    /const \[hiddenBusy, setHiddenBusy\] = useState\(false\)/,
  );
  assert.match(editor, /!workflow \|\| !workflow\.is_system \|\| hiddenBusy/);
  assert.match(editor, /label: hiddenBusy \? "正在隐藏…" : "隐藏内置模板"/);
  assert.match(editor, /disabled: hiddenBusy/);
  assert.match(editor, /finally \{\s*setHiddenBusy\(false\);\s*\}/);
  assert.doesNotMatch(
    `${list}\n${editor}\n${adapter}`,
    /Supabase|PeopleModal|open-source|shareWorkflow|\/runs|startRun|retryRun/i,
  );
  assert.doesNotMatch(
    `${list}\n${editor}`,
    /fixture|mockData|fallbackWorkflow|window\.(?:confirm|prompt|alert)/i,
  );
  assert.match(
    sidebar,
    /href:\s*null,\s*labelKey:\s*"nav\.workflows"/,
    "root integration alone may enable the Workflow navigation item",
  );
});
