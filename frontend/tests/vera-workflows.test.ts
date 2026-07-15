import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertNoVeraWorkflowSensitiveFields,
  cancelVeraWorkflowRun,
  createVeraWorkflow,
  deleteVeraWorkflow,
  getVeraWorkflowExecutionCapabilities,
  getVeraWorkflowDefinition,
  getVeraWorkflow,
  getVeraWorkflowRun,
  hideVeraWorkflow,
  listHiddenVeraWorkflows,
  listVeraWorkflowRuns,
  listVeraWorkflows,
  parseVeraPreparedWorkflowRun,
  parseVeraWorkflow,
  parseVeraWorkflowDefinition,
  parseVeraWorkflowRun,
  parseVeraWorkflowRunPage,
  retryVeraWorkflowRun,
  startVeraWorkflowRun,
  unhideVeraWorkflow,
  updateVeraWorkflow,
  updateVeraWorkflowDefinition,
} from "../src/app/lib/veraWorkflowApi.ts";
import { VeraApiError } from "../src/app/lib/veraApi.ts";
import { MESSAGES } from "../src/app/i18n/messages.ts";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const STEP_ID = "33333333-3333-4333-8333-333333333333";
const DEFINITION_STEP_ID = "99999999-9999-4999-8999-999999999999";
const RETRIEVAL_STEP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTPUT_STEP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const MODEL_ID = "55555555-5555-4555-8555-555555555555";
const JOB_ID = "66666666-6666-4666-8666-666666666666";
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

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    workflow_id: WORKFLOW_ID,
    project_id: PROJECT_ID,
    status: "running",
    model_profile_id: MODEL_ID,
    job_id: JOB_ID,
    retry_of_run_id: null,
    input: { additional_instructions: "只分析终止条款。" },
    output: null,
    started_at: "2026-07-15T01:02:03.004Z",
    completed_at: null,
    error: null,
    created_at: "2026-07-15T01:02:02.003Z",
    ...overrides,
  };
}

function step(overrides: Record<string, unknown> = {}) {
  return {
    id: STEP_ID,
    workflow_run_id: RUN_ID,
    ordinal: 0,
    attempt: 1,
    step: {
      id: DEFINITION_STEP_ID,
      kind: "prompt",
      title: "执行工作流",
      prompt: "分析。",
      model_profile_id: MODEL_ID,
    },
    status: "running",
    input: { additional_instructions: "只分析终止条款。" },
    output: null,
    error: null,
    started_at: "2026-07-15T01:02:03.004Z",
    completed_at: null,
    ...overrides,
  };
}

function definition(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    type: "assistant",
    name: "合同摘要",
    description: "检索项目文档并输出结构化摘要。",
    project_id: PROJECT_ID,
    steps: [
      {
        id: RETRIEVAL_STEP_ID,
        type: "document_retrieval",
        name: "检索文档",
        query_template: "重大违约 终止",
        limit: 8,
      },
      {
        id: DEFINITION_STEP_ID,
        type: "prompt",
        name: "分析条款",
        prompt: "基于检索内容分析终止权。",
        model_profile_id: MODEL_ID,
        input_mapping: {},
      },
      {
        id: OUTPUT_STEP_ID,
        type: "output",
        name: "输出结果",
        format: "json",
      },
    ],
    updated_at: "2026-07-15T01:02:03.004Z",
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

test("workflow definition parser is strict about stable IDs, bounded step kinds, and output ordering", () => {
  const parsed = parseVeraWorkflowDefinition(definition());
  assert.equal(parsed.steps.length, 3);
  assert.equal(parsed.steps[0]?.type, "document_retrieval");
  assert.equal(parsed.steps[1]?.id, DEFINITION_STEP_ID);
  assert.equal(parsed.steps[2]?.type, "output");

  assert.throws(
    () =>
      parseVeraWorkflowDefinition({
        ...definition(),
        steps: [
          {
            id: DEFINITION_STEP_ID,
            type: "prompt",
            name: "分析",
            prompt: "分析文档。",
            input_mapping: { claim: "input.claim" },
          },
        ],
      }),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraWorkflowDefinition({
        ...definition(),
        steps: [
          {
            id: OUTPUT_STEP_ID,
            type: "output",
            name: "过早输出",
            format: "text",
          },
          {
            id: DEFINITION_STEP_ID,
            type: "prompt",
            name: "分析",
            prompt: "分析文档。",
          },
        ],
      }),
    VeraApiError,
  );
  assert.throws(
    () => parseVeraWorkflowDefinition({ ...definition(), extra: true }),
    VeraApiError,
  );
});

test("workflow definition GET and PUT use the strict local boundary without fallback state", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (!url.endsWith(`/workflows/${WORKFLOW_ID}/definition`)) {
      throw new Error(`unexpected route ${url}`);
    }
    const response =
      init?.method === "PUT"
        ? {
            ...definition(),
            ...JSON.parse(String(init.body)),
            updated_at: "2026-07-15T02:03:04.005Z",
          }
        : definition();
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    assert.equal((await getVeraWorkflowDefinition(WORKFLOW_ID)).name, "合同摘要");
    const updated = await updateVeraWorkflowDefinition(WORKFLOW_ID, {
      name: "重大违约审阅",
      description: null,
      project_id: PROJECT_ID,
      steps: [
        {
          id: DEFINITION_STEP_ID,
          type: "prompt",
          name: "分析",
          prompt: "识别重大违约条款。",
          model_profile_id: MODEL_ID,
        },
        {
          id: OUTPUT_STEP_ID,
          type: "output",
          name: "输出",
          format: "text",
        },
      ],
    });
    assert.equal(updated.name, "重大违约审阅");
    assert.equal(calls[0]?.init?.method, "GET");
    assert.equal(calls[1]?.init?.method, "PUT");
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
      name: "重大违约审阅",
      description: null,
      project_id: PROJECT_ID,
      steps: [
        {
          id: DEFINITION_STEP_ID,
          type: "prompt",
          name: "分析",
          prompt: "识别重大违约条款。",
          model_profile_id: MODEL_ID,
        },
        {
          id: OUTPUT_STEP_ID,
          type: "output",
          name: "输出",
          format: "text",
        },
      ],
    });
    for (const call of calls) {
      assert.equal(
        new Headers(call.init?.headers).get("authorization"),
        `Bearer ${TOKEN}`,
      );
    }

    const beforeInvalid = calls.length;
    await assert.rejects(
      updateVeraWorkflowDefinition(WORKFLOW_ID, {
        name: "错误定义",
        description: null,
        project_id: null,
        steps: [
          {
            id: DEFINITION_STEP_ID,
            type: "prompt",
            name: "分析",
            prompt: "分析。",
            input_mapping: { unsupported: true } as never,
          },
        ],
      }),
      VeraApiError,
    );
    assert.equal(calls.length, beforeInvalid);
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("workflow run parser accepts safe object arrays, rejects cycles, sensitive data, extra keys, and noncanonical time", () => {
  assert.doesNotThrow(() =>
    assertNoVeraWorkflowSensitiveFields([
      { citation: { document_id: "doc-1", quote: "条款内容" } },
      { metrics: [1, 2, 3] },
    ]),
  );
  const sharedSafeObject = { document_id: "doc-1" };
  assert.doesNotThrow(() =>
    assertNoVeraWorkflowSensitiveFields([
      sharedSafeObject,
      { same_document: sharedSafeObject },
    ]),
  );
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(
    () => assertNoVeraWorkflowSensitiveFields(cycle),
    VeraApiError,
  );

  const parsed = parseVeraPreparedWorkflowRun({
    run: run({
      status: "complete",
      output: {
        content: "终止条款允许在重大违约后解除合同。",
        citations: [{ document_id: "doc-1", quote: "重大违约" }],
      },
      completed_at: "2026-07-15T01:03:04.005Z",
    }),
    steps: [
      step({
        status: "complete",
        output: { content: "已完成真实模型调用。" },
        completed_at: "2026-07-15T01:03:04.005Z",
      }),
    ],
    reused: false,
  });
  assert.equal(parsed.run.status, "complete");
  assert.equal(parsed.steps[0].attempt, 1);

  assert.throws(
    () => parseVeraWorkflowRun({ ...run(), provider_response: {} }),
    VeraApiError,
  );
  assert.throws(
    () => parseVeraWorkflowRun({ ...run(), output: { credential_ref: "x" } }),
    VeraApiError,
  );
  assert.throws(
    () => parseVeraWorkflowRun({ ...run(), output: { file_path: "/tmp/x" } }),
    VeraApiError,
  );
  assert.throws(
    () => parseVeraWorkflowRun({ ...run(), output: { note: "/Users/alice/a" } }),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraWorkflowRun({
        ...run(),
        created_at: "2026-07-15T01:02:02Z",
      }),
    VeraApiError,
  );
});

test("workflow run pages require a safe base64url cursor", () => {
  const page = parseVeraWorkflowRunPage({
    items: [run()],
    next_cursor: "eyJjcmVhdGVkQXQiOiJ4IiwiaWQiOiJ5In0",
  });
  assert.equal(page.items.length, 1);
  assert.match(page.next_cursor ?? "", /^[A-Za-z0-9_-]+$/);
  assert.throws(
    () => parseVeraWorkflowRunPage({ items: [], next_cursor: "bad/cursor=" }),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraWorkflowRunPage({
        items: [],
        next_cursor: "/Users/alice/workspace",
      }),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraWorkflowRunPage({
        items: [],
        next_cursor: "Bearer abcdefghijklmnop",
      }),
    VeraApiError,
  );
});

test("workflow execution API uses exact durable run, history, cancel, and retry routes", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const retryRunId = "77777777-7777-4777-8777-777777777777";
  const retryStepId = "88888888-8888-4888-8888-888888888888";
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/workflows/capabilities")) {
      return json({
        execution_enabled: true,
        assistant_runs: true,
        tabular_runs: false,
      });
    }
    if (url.includes(`/workflows/${WORKFLOW_ID}/runs?`)) {
      return json({ items: [run()], next_cursor: null });
    }
    if (url.endsWith(`/workflows/${WORKFLOW_ID}/runs`)) {
      return json({ run: run({ status: "queued", started_at: null }), steps: [step({ status: "queued", started_at: null })], reused: false }, 202);
    }
    if (url.endsWith(`/workflow-runs/${RUN_ID}/cancel`)) {
      return json({
        run: run({
          status: "cancelled",
          completed_at: "2026-07-15T01:04:05.006Z",
        }),
        steps: [
          step({
            status: "cancelled",
            completed_at: "2026-07-15T01:04:05.006Z",
          }),
        ],
      });
    }
    if (url.endsWith(`/workflow-runs/${RUN_ID}/retry`)) {
      return json(
        {
          run: run({
            id: retryRunId,
            status: "queued",
            started_at: null,
            retry_of_run_id: RUN_ID,
          }),
          steps: [
            step({
              id: retryStepId,
              workflow_run_id: retryRunId,
              status: "queued",
              started_at: null,
            }),
          ],
          reused: false,
        },
        202,
      );
    }
    if (url.endsWith(`/workflow-runs/${RUN_ID}`)) {
      return json({ run: run(), steps: [step()] });
    }
    throw new Error(`unexpected route ${url}`);
  };

  try {
    assert.deepEqual(await getVeraWorkflowExecutionCapabilities(), {
      execution_enabled: true,
      assistant_runs: true,
      tabular_runs: false,
    });
    assert.equal(
      (await listVeraWorkflowRuns(WORKFLOW_ID, { limit: 25 })).items.length,
      1,
    );
    await startVeraWorkflowRun(WORKFLOW_ID, {
      idempotency_key: "vera-workflow-run-test",
      project_id: PROJECT_ID,
      model_profile_id: MODEL_ID,
      input_binding: { additional_instructions: "聚焦重大违约。" },
    });
    assert.equal((await getVeraWorkflowRun(RUN_ID)).run.id, RUN_ID);
    assert.equal((await cancelVeraWorkflowRun(RUN_ID)).run.status, "cancelled");
    assert.equal(
      (await retryVeraWorkflowRun(RUN_ID, "vera-workflow-retry-test")).run
        .retry_of_run_id,
      RUN_ID,
    );

    assert.equal(calls[2].init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[2].init?.body)), {
      idempotency_key: "vera-workflow-run-test",
      project_id: PROJECT_ID,
      model_profile_id: MODEL_ID,
      input_binding: { additional_instructions: "聚焦重大违约。" },
    });
    assert.equal(calls[4].init?.method, "POST");
    assert.equal(calls[4].init?.body, "{}");
    assert.equal(calls[5].init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[5].init?.body)), {
      idempotency_key: "vera-workflow-retry-test",
    });
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(call.url.includes(TOKEN), false);
    }

    const beforeRejectedInput = calls.length;
    await assert.rejects(
      startVeraWorkflowRun(WORKFLOW_ID, {
        idempotency_key: "reject-secret",
        model_profile_id: MODEL_ID,
        input_binding: { credential_ref: "never-send" },
      }),
      VeraApiError,
    );
    await assert.rejects(
      listVeraWorkflowRuns(WORKFLOW_ID, { cursor: "bad/cursor=" }),
      VeraApiError,
    );
    assert.equal(calls.length, beforeRejectedInput);
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
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

test("Workflow UI retains pinned Mike provenance and connects only durable local execution", () => {
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
  const promptEditor = readFileSync(
    path.join(
      root,
      "src/app/components/workflows/VeraWorkflowPromptEditor.tsx",
    ),
    "utf8",
  );
  const runPanel = readFileSync(
    path.join(root, "src/app/components/workflows/VeraWorkflowRunPanel.tsx"),
    "utf8",
  );
  const definitionEditor = readFileSync(
    path.join(
      root,
      "src/app/components/workflows/VeraWorkflowDefinitionEditor.tsx",
    ),
    "utf8",
  );
  const projectRoute = readFileSync(
    path.join(root, "src/app/(pages)/projects/[id]/workflows/page.tsx"),
    "utf8",
  );
  assert.match(list, /e32daad5a4c64a5561e04c53ee12411e3c5e7238/);
  assert.match(editor, /e32daad5a4c64a5561e04c53ee12411e3c5e7238/);
  assert.match(promptEditor, /WorkflowPromptEditor\.tsx/);
  assert.match(runPanel, /UseWorkflowModal\.tsx/);
  assert.match(definitionEditor, /e32daad5a4c64a5561e04c53ee12411e3c5e7238/);
  assert.match(adapter, /frontend\/src\/app\/lib\/mikeApi\.ts/);
  assert.match(list, /listVeraWorkflows\("assistant"/);
  assert.match(list, /listVeraWorkflows\("tabular"/);
  assert.match(list, /listHiddenVeraWorkflows/);
  assert.match(editor, /VERA_WORKFLOW_FORMATS/);
  assert.match(editor, /VeraWorkflowPromptEditor/);
  assert.match(editor, /VeraWorkflowRunPanel/);
  assert.match(editor, /getVeraWorkflowDefinition/);
  assert.match(editor, /VeraWorkflowDefinitionEditor/);
  assert.match(editor, /useI18n/);
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
  assert.match(list, /workflows\.list\.clearFilters/);
  assert.match(MESSAGES["zh-CN"].workflows.list.clearFilters, /清除筛选/);
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
  assert.match(editor, /workflows\.editor\.hidingBuiltin/);
  assert.match(editor, /workflows\.editor\.hideBuiltin/);
  assert.match(editor, /disabled: hiddenBusy/);
  assert.match(editor, /finally \{\s*setHiddenBusy\(false\);\s*\}/);
  assert.doesNotMatch(
    `${list}\n${editor}\n${definitionEditor}\n${adapter}\n${runPanel}`,
    /Supabase|PeopleModal|open-source|shareWorkflow/i,
  );
  assert.doesNotMatch(
    `${list}\n${editor}\n${definitionEditor}\n${runPanel}`,
    /fixture|mockData|fallbackWorkflow|localStorage|sessionStorage|setInterval|EventSource|window\.(?:confirm|prompt|alert)/i,
  );
  for (const method of [
    "getVeraWorkflowExecutionCapabilities",
    "listVeraWorkflowRuns",
    "getVeraWorkflowRun",
    "startVeraWorkflowRun",
    "cancelVeraWorkflowRun",
    "retryVeraWorkflowRun",
  ]) {
    assert.match(runPanel, new RegExp(method));
  }
  assert.match(runPanel, /WORKFLOW_RUN_POLL_MAX_FAILURES/);
  assert.match(runPanel, /AbortController/);
  assert.match(runPanel, /detail\.run\.error\?\.retryable === true/);
  assert.match(runPanel, /step\.step\.id/);
  assert.match(runPanel, /step\.input/);
  assert.match(runPanel, /step\.output/);
  assert.match(runPanel, /workflow\.metadata\.type === "tabular"/);
  assert.match(runPanel, /router\.push\("\/projects"\)/);
  assert.match(adapter, /assertNoVeraWorkflowSensitiveFields/);
  assert.match(adapter, /STRICT_UTC_ISO_MILLISECONDS_PATTERN/);
  assert.match(adapter, /parseVeraWorkflowDefinition/);
  assert.match(adapter, /updateVeraWorkflowDefinition/);
  for (const capability of [
    /type === "prompt"/,
    /type === "document_retrieval"/,
    /type === "output"/,
    /query_template/,
    /model_profile_id/,
    /inputMappingHint/,
    /moveStep/,
    /removeStep/,
  ]) {
    assert.match(definitionEditor, capability);
  }
  assert.match(projectRoute, /VeraWorkflowList projectId=\{id\}/);
  assert.match(
    sidebar,
    /href:\s*"\/workflows",\s*labelKey:\s*"nav\.workflows"/,
    "the complete local Workflow client must be reachable from the shell",
  );
});
