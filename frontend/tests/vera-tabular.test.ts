import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  assertNoVeraTabularSensitiveFields,
  createVeraTabularReview,
  parseVeraTabularCapabilities,
  parseVeraTabularCell,
  parseVeraTabularReview,
  parseVeraTabularReviewDetail,
} from "../src/app/lib/veraTabularApi.ts";
import {
  clampTabularPage,
  tabularPageCount,
  TABULAR_ROWS_PER_PAGE,
} from "../src/app/components/tabular/TRTable.tsx";
import { contractReviewBucketFor } from "../src/app/components/tabular/ContractReviewIssues.tsx";
import { projectedContractReviewColumns } from "../src/app/components/tabular/ContractReviewModal.tsx";
import {
  sourceIdentity,
  tabularSourceOffsetLabel,
  tabularSourcePageLabel,
} from "../src/app/components/tabular/citation-utils.ts";

const REVIEW_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "10000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "10000000-0000-4000-8000-000000000003";
const VERSION_ID = "10000000-0000-4000-8000-000000000004";
const CHUNK_ID = "10000000-0000-4000-8000-000000000005";
const MODEL_ID = "10000000-0000-4000-8000-000000000006";
const CELL_ID = "10000000-0000-4000-8000-000000000007";
const WORKFLOW_ID = "10000000-0000-4000-8000-000000000008";
const BUILTIN_WORKFLOW_ID = "builtin-commercial-agreement-tabular-review";
const NOW = "2026-07-15T10:00:00.000Z";
const TOKEN = "vtr_1234567890abcdefghijklmnopqrstuvwxyz";

function reviewWire(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    project_id: PROJECT_ID,
    user_id: USER_ID,
    title: "Contract review",
    columns_config: [
      {
        index: 0,
        name: "Governing law",
        prompt: "Return the governing law and cite the exact clause.",
        format: "text",
        tags: [],
      },
    ],
    document_ids: [DOCUMENT_ID],
    workflow_id: null,
    model_profile_id: MODEL_ID,
    status: "complete",
    practice: null,
    shared_with: [],
    is_owner: true,
    created_at: NOW,
    updated_at: NOW,
    document_count: 1,
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

function sourceWire() {
  return {
    document_id: DOCUMENT_ID,
    version_id: VERSION_ID,
    chunk_id: CHUNK_ID,
    quote: "This agreement is governed by the laws of New York.",
    start_offset: 120,
    end_offset: 172,
    page_start: 4,
    page_end: 4,
  };
}

function cellWire() {
  return {
    id: CELL_ID,
    review_id: REVIEW_ID,
    document_id: DOCUMENT_ID,
    column_index: 0,
    content: {
      summary: "New York law",
      flag: "green",
      reasoning: "The governing-law clause states this expressly.",
    },
    status: "done",
    error: null,
    sources: [sourceWire()],
    attempt: 1,
    created_at: NOW,
    updated_at: NOW,
    completed_at: NOW,
  };
}

function documentWire() {
  return {
    id: DOCUMENT_ID,
    user_id: USER_ID,
    project_id: PROJECT_ID,
    folder_id: null,
    filename: "Agreement.pdf",
    owner_email: null,
    owner_display_name: "Local User",
    file_type: "pdf",
    storage_path: null,
    pdf_storage_path: "local-preview",
    size_bytes: 1024,
    page_count: 12,
    structure_tree: null,
    status: "ready",
    created_at: NOW,
    updated_at: NOW,
    active_version_number: 1,
    latest_version_number: 1,
  };
}

test("Tabular exact contracts accept one complete persisted matrix", () => {
  const review = parseVeraTabularReview(reviewWire());
  const cell = parseVeraTabularCell(cellWire());
  const detail = parseVeraTabularReviewDetail({
    review: reviewWire(),
    cells: [cellWire()],
    documents: [documentWire()],
  });

  assert.equal(review.document_count, 1);
  assert.equal(cell.sources[0]?.quote, sourceWire().quote);
  assert.equal(detail.cells[0]?.content?.summary, "New York law");
  assert.deepEqual(
    parseVeraTabularCapabilities({ generation: true, chat: false }),
    {
      generation: true,
      chat: false,
    },
  );
});

test("Tabular contracts reject unknown keys, matrix drift, and unsafe data", () => {
  assert.throws(() =>
    parseVeraTabularReview({ ...reviewWire(), provider_payload: {} }),
  );
  assert.throws(() =>
    parseVeraTabularReview({ ...reviewWire(), document_count: 2 }),
  );
  assert.throws(() =>
    parseVeraTabularReview({
      ...reviewWire(),
      columns_config: [{ ...reviewWire().columns_config[0], index: 1 }],
    }),
  );
  assert.throws(() =>
    parseVeraTabularReviewDetail({
      review: reviewWire(),
      cells: [],
      documents: [documentWire()],
    }),
  );
  assert.throws(() =>
    parseVeraTabularCell({
      ...cellWire(),
      sources: [{ ...sourceWire(), document_id: PROJECT_ID }],
    }),
  );
  assert.throws(() =>
    assertNoVeraTabularSensitiveFields({
      error: { message: "Bearer local-secret-token-value" },
    }),
  );
  assert.throws(() =>
    assertNoVeraTabularSensitiveFields({
      quote: "See /Users/local/private.txt",
    }),
  );
  assert.throws(() =>
    assertNoVeraTabularSensitiveFields({
      documents: [{ storage_path: "/private/vera/blob" }],
    }),
  );
});

test("Tabular cell lifecycle invariants fail closed", () => {
  assert.throws(() =>
    parseVeraTabularCell({
      ...cellWire(),
      status: "done",
      content: null,
    }),
  );
  assert.throws(() =>
    parseVeraTabularCell({
      ...cellWire(),
      status: "error",
      content: null,
      error: null,
      completed_at: null,
    }),
  );
  assert.throws(() =>
    parseVeraTabularCell({
      ...cellWire(),
      sources: [{ ...sourceWire(), end_offset: 100 }],
    }),
  );
  assert.throws(() =>
    parseVeraTabularCell({
      ...cellWire(),
      sources: [{ ...sourceWire(), version_id: null }],
    }),
  );
});

test("Tabular pagination keeps large matrices bounded and navigable", () => {
  assert.equal(TABULAR_ROWS_PER_PAGE, 25);
  assert.equal(tabularPageCount(0), 1);
  assert.equal(tabularPageCount(26), 2);
  assert.equal(tabularPageCount(1000), 40);
  assert.equal(clampTabularPage(-4, 1000), 0);
  assert.equal(clampTabularPage(99, 1000), 39);
});

test("structured source labels retain page and exact offset identity", () => {
  const source = parseVeraTabularCell(cellWire()).sources[0]!;
  assert.equal(tabularSourcePageLabel(source), "4");
  assert.equal(tabularSourceOffsetLabel(source), "120–172");
  assert.equal(
    sourceIdentity(source),
    `${DOCUMENT_ID}:${VERSION_ID}:${CHUNK_ID}:120:172`,
  );
});

test("Contract Review uses the server workflow projection without exposing editable prompts", () => {
  const columns = projectedContractReviewColumns({
    id: WORKFLOW_ID,
    user_id: null,
    metadata: {
      title: "Commercial contract review",
      description: "Server-managed review checks.",
      type: "tabular",
      contributors: [],
      language: "English",
      version: "2026.1",
      practice: "Commercial",
      jurisdictions: ["England and Wales"],
    },
    skill_md: "Server-owned execution instructions",
    columns_config: [
      {
        index: 0,
        name: "Governing law",
        prompt: "Return the governing law with an exact source.",
        format: "text",
        tags: ["boilerplate"],
      },
    ],
    is_system: true,
    created_at: "",
    shared_by_name: null,
    allow_edit: false,
    is_owner: false,
    open_source_submission: null,
  });
  assert.deepEqual(columns, [
    {
      index: 0,
      name: "Governing law",
      prompt: "Return the governing law with an exact source.",
      format: "text",
      tags: ["boilerplate"],
    },
  ]);
});

test("workflow-bound Tabular creation omits columns but verifies the server snapshot", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify(reviewWire({ workflow_id: BUILTIN_WORKFLOW_ID })),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const created = await createVeraTabularReview({
      title: "Contract review",
      project_id: PROJECT_ID,
      document_ids: [DOCUMENT_ID],
      columns_config: reviewWire().columns_config,
      model_profile_id: MODEL_ID,
      workflow_id: BUILTIN_WORKFLOW_ID,
    });
    assert.equal(created.workflow_id, BUILTIN_WORKFLOW_ID);
    assert.equal(body?.workflow_id, BUILTIN_WORKFLOW_ID);
    assert.equal(Object.hasOwn(body ?? {}, "columns_config"), false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Contract Review Issues groups only persisted status and flags", () => {
  const red = parseVeraTabularCell({
    ...cellWire(),
    content: { ...cellWire().content, flag: "red" },
  });
  const unflaggedNaturalLanguage = parseVeraTabularCell({
    ...cellWire(),
    content: {
      summary: "The expected clause appears to be missing.",
      reasoning: "A lawyer must verify the source.",
    },
  });
  const failed = parseVeraTabularCell({
    ...cellWire(),
    content: null,
    status: "error",
    error: {
      code: "MODEL_FAILED",
      message: "Generation failed.",
      retryable: true,
      details: null,
    },
  });
  assert.equal(contractReviewBucketFor(red), "red");
  assert.equal(contractReviewBucketFor(unflaggedNaturalLanguage), "grey");
  assert.equal(contractReviewBucketFor(failed), "error");
});

test("Mike-pinned Tabular client is wired to Vera routes without simulated execution", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const required = [
    "src/app/components/tabular/TRTable.tsx",
    "src/app/components/tabular/TabularCell.tsx",
    "src/app/components/tabular/TabularReviewView.tsx",
    "src/app/components/tabular/AddColumnModal.tsx",
    "src/app/components/tabular/TREditColumnMenu.tsx",
    "src/app/components/tabular/TRSidePanel.tsx",
    "src/app/components/tabular/NewTRModal.tsx",
    "src/app/components/tabular/TabularReviewDetailsModal.tsx",
    "src/app/components/tabular/TabularDocumentsModal.tsx",
    "src/app/components/projects/ProjectReviewsTable.tsx",
    "src/app/components/tabular/citation-utils.ts",
    "src/app/components/tabular/columnFormat.ts",
  ];
  const sources = await Promise.all(
    required.map((file) => readFile(path.join(root, file), "utf8")),
  );
  for (const source of sources) {
    assert.match(source, /e32daad5a4c64a5561e04c53ee12411e3c5e7238/);
  }

  const api = await readFile(
    path.join(root, "src/app/lib/veraTabularApi.ts"),
    "utf8",
  );
  const view = sources[2]!;
  const sidebar = await readFile(
    path.join(root, "src/app/components/vera-shell/VeraSidebar.tsx"),
    "utf8",
  );
  const projectWorkspace = await readFile(
    path.join(root, "src/app/components/projects/ProjectWorkspace.tsx"),
    "utf8",
  );
  const workspaceRoutes = await readFile(
    path.join(root, "src/app/components/projects/WorkspaceRouteAdapter.tsx"),
    "utf8",
  );
  const legacyRoute = await readFile(
    path.join(root, "src/app/(pages)/tabular-review/page.tsx"),
    "utf8",
  );

  assert.match(api, /\/tabular-review\/\$\{safeId\(reviewId/);
  assert.match(api, /streamVeraSse/);
  assert.match(api, /export\.\$\{format\}/);
  assert.match(view, /streamVeraTabularGeneration/);
  assert.match(view, /cancelVeraTabularCell/);
  assert.match(view, /regenerateVeraTabularCell/);
  assert.match(view, /clearVeraTabularCells/);
  assert.match(view, /exportVeraTabularReview/);
  assert.match(view, /runBoundedMutations/);
  assert.match(view, /clearConfirmDocumentIds/);
  assert.match(view, /projectChanged/);
  assert.doesNotMatch(
    view,
    /setTimeout|mockData|TRChatPanel|Promise\.allSettled/,
  );
  assert.doesNotMatch(sidebar, /href: "\/tabular-review"/);
  assert.match(legacyRoute, /<TabularReviewsList \/>/);
  assert.match(projectWorkspace, /routes\.tabularReviewsHref\(projectId\)/);
  assert.match(workspaceRoutes, /\/projects\/\$\{projectId\}\/tabular-reviews/);
});

test("Matter Contract Review keeps generic creation and binds a server-managed tabular workflow", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const modal = await readFile(
    path.join(root, "src/app/components/tabular/ContractReviewModal.tsx"),
    "utf8",
  );
  const issues = await readFile(
    path.join(root, "src/app/components/tabular/ContractReviewIssues.tsx"),
    "utf8",
  );
  const view = await readFile(
    path.join(root, "src/app/components/tabular/TabularReviewView.tsx"),
    "utf8",
  );
  const page = await readFile(
    path.join(root, "src/app/(pages)/projects/[id]/tabular-reviews/page.tsx"),
    "utf8",
  );
  const workflowPanel = await readFile(
    path.join(root, "src/app/components/workflows/VeraWorkflowRunPanel.tsx"),
    "utf8",
  );
  const studioApi = await readFile(
    path.join(root, "src/app/lib/veraDocumentStudioApi.ts"),
    "utf8",
  );

  assert.match(modal, /listVeraWorkflows\("tabular"/);
  assert.match(modal, /listHiddenVeraWorkflows/);
  assert.match(modal, /workflow\.is_system/);
  assert.match(modal, /workflow_id: workflow\.id/);
  assert.match(modal, /columns_config: columns/);
  assert.doesNotMatch(modal, /\{column\.prompt\}/);
  assert.doesNotMatch(modal, /systemInstructions|system_instructions/);
  assert.match(page, /<NewTRModal/);
  assert.match(page, /<ContractReviewModal/);
  assert.match(page, /searchParams\.get\("workflow_id"\)/);
  assert.match(workflowPanel, /routes\.tabularReviewsHref\(projectId\)/);
  assert.match(workflowPanel, /encodeURIComponent\(workflow\.id\)/);
  assert.match(view, /getVeraWorkflow\(boundWorkflowId/);
  assert.match(view, /reviewView === "issues"/);
  assert.match(view, /createVeraStudioDraftFromTabularReview/);
  assert.match(view, /currentReview\.status !== "complete"/);
  assert.match(studioApi, /studio\/drafts\/from-tabular/);
  assert.match(studioApi, /json: \{ review_id:/);
  assert.match(view, /canEditColumns=\{columnsMutable\}/);
  assert.match(issues, /detail\.cells/);
  assert.match(issues, /cell\.content\?\.flag \?\? "grey"/);
  assert.doesNotMatch(issues, /missing|deviation|aligned/i);
  assert.doesNotMatch(
    `${modal}\n${view}\n${issues}`,
    /contract-review-playbooks|\/contract-reviews/,
  );
});
